import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GeoStateEntity, GeoDistrictEntity, GeoCityEntity } from './geo.entities';

@Injectable()
export class GeoSeedService implements OnModuleInit {
  constructor(
    @InjectRepository(GeoStateEntity)
    private readonly stateRepo: Repository<GeoStateEntity>,
    @InjectRepository(GeoDistrictEntity)
    private readonly districtRepo: Repository<GeoDistrictEntity>,
    @InjectRepository(GeoCityEntity)
    private readonly cityRepo: Repository<GeoCityEntity>,
  ) {}

  async onModuleInit() {
    const count = await this.stateRepo.count();
    if (count > 0) return;

    const statesData = [
      { name: 'Maharashtra', code: 'MH', districts: [
        { name: 'Mumbai', cities: [{ name: 'Mumbai City', pincode: '400001' }] },
        { name: 'Pune', cities: [{ name: 'Pune City', pincode: '411001' }, { name: 'Pimpri-Chinchwad', pincode: '411018' }] },
        { name: 'Nagpur', cities: [{ name: 'Nagpur', pincode: '440001' }] },
        { name: 'Thane', cities: [{ name: 'Thane', pincode: '400601' }] },
        { name: 'Nashik', cities: [{ name: 'Nashik', pincode: '422001' }] },
        { name: 'Aurangabad', cities: [{ name: 'Aurangabad', pincode: '431001' }] },
        { name: 'Solapur', cities: [{ name: 'Solapur', pincode: '413001' }] },
      ]},
      { name: 'Gujarat', code: 'GJ', districts: [
        { name: 'Ahmedabad', cities: [{ name: 'Ahmedabad City', pincode: '380001' }] },
        { name: 'Surat', cities: [{ name: 'Surat City', pincode: '395003' }] },
        { name: 'Vadodara', cities: [{ name: 'Vadodara', pincode: '390001' }] },
        { name: 'Rajkot', cities: [{ name: 'Rajkot', pincode: '360001' }] },
      ]},
      { name: 'Karnataka', code: 'KA', districts: [
        { name: 'Bangalore Urban', cities: [{ name: 'Bangalore', pincode: '560001' }] },
        { name: 'Mysore', cities: [{ name: 'Mysore', pincode: '570001' }] },
        { name: 'Hubli', cities: [{ name: 'Hubli', pincode: '580001' }] },
      ]},
      { name: 'Tamil Nadu', code: 'TN', districts: [
        { name: 'Chennai', cities: [{ name: 'Chennai', pincode: '600001' }] },
        { name: 'Coimbatore', cities: [{ name: 'Coimbatore', pincode: '641001' }] },
      ]},
      { name: 'Uttar Pradesh', code: 'UP', districts: [
        { name: 'Lucknow', cities: [{ name: 'Lucknow', pincode: '226001' }] },
        { name: 'Kanpur', cities: [{ name: 'Kanpur', pincode: '208001' }] },
      ]},
      { name: 'West Bengal', code: 'WB', districts: [
        { name: 'Kolkata', cities: [{ name: 'Kolkata', pincode: '700001' }] },
      ]},
      { name: 'Rajasthan', code: 'RJ', districts: [
        { name: 'Jaipur', cities: [{ name: 'Jaipur', pincode: '302001' }] },
      ]},
      { name: 'Delhi', code: 'DL', districts: [
        { name: 'New Delhi', cities: [{ name: 'New Delhi', pincode: '110001' }] },
      ]},
    ];

    for (const sd of statesData) {
      const state = this.stateRepo.create({ name: sd.name, code: sd.code, createdBy: 'system', updatedBy: 'system' });
      await this.stateRepo.save(state);
      for (const dd of sd.districts) {
        const district = this.districtRepo.create({ name: dd.name, stateId: state.id, createdBy: 'system', updatedBy: 'system' });
        await this.districtRepo.save(district);
        for (const cd of dd.cities) {
          const city = this.cityRepo.create({ name: cd.name, districtId: district.id, pincode: cd.pincode, createdBy: 'system', updatedBy: 'system' });
          await this.cityRepo.save(city);
        }
      }
    }
  }
}
